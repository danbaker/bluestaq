import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, it, expect, vi } from "vitest";
import NotesPage from "./NotesPage";
import { bodiesOf, calledWith, listNote, mockApi, privateSpace, team } from "./testUtils";

afterEach(() => vi.unstubAllGlobals());

function renderPage(onSessionEnded = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<NotesPage onSessionEnded={onSessionEnded} />} />
        <Route path="/notes/:id" element={<p>Opened note page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { onSessionEnded };
}

describe("NotesPage", () => {
  it("shows every team with its notes (team name, note title, preview), teams sorted ignoring case", async () => {
    mockApi({
      "GET /api/teams": { body: [team(2, "beta"), team(1, "Alpha"), team(3, "Zulu")] },
      "GET /api/notes": {
        body: [
          listNote("n1", 1, "Alpha", "Standup", "talked about the release"),
          listNote("n2", 1, "Alpha", "Retro"),
          listNote("n3", 2, "beta", "Ideas"),
        ],
      },
    });
    renderPage();
    const sections = await screen.findAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["Alpha", "beta", "Zulu"]);

    const alpha = within(sections[0]);
    expect(alpha.getByRole("link", { name: /Standup/ })).toHaveAttribute("href", "/notes/n1");
    expect(alpha.getByText("talked about the release")).toBeInTheDocument();
    expect(alpha.getByRole("link", { name: "Retro" })).toBeInTheDocument();
    expect(within(sections[1]).getByRole("link", { name: "Ideas" })).toBeInTheDocument();
    expect(within(sections[1]).queryByText("Standup")).not.toBeInTheDocument(); // notes stay under their own team
    expect(within(sections[2]).getByText("No notes yet.")).toBeInTheDocument(); // teams with no notes still show
  });

  it("clicking a note opens its page", async () => {
    mockApi({
      "GET /api/teams": { body: [team(1, "Alpha")] },
      "GET /api/notes": { body: [listNote("n1", 1, "Alpha", "Standup")] },
    });
    renderPage();
    await userEvent.click(await screen.findByRole("link", { name: "Standup" }));
    expect(await screen.findByText("Opened note page")).toBeInTheDocument();
  });

  it("a new user sees their private space and is told how to share notes", async () => {
    mockApi({ "GET /api/teams": { body: [privateSpace(1)] }, "GET /api/notes": { body: [] } });
    renderPage();
    const space = within(await screen.findByRole("region", { name: "Private" }));
    expect(space.getByText("No private notes yet.")).toBeInTheDocument();
    expect(space.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.getByText(/Create a team below to share notes/)).toBeInTheDocument();
  });

  it("the private space is shown first and marked as only for you, with its notes next to the team notes", async () => {
    mockApi({
      "GET /api/teams": { body: [team(2, "Aardvarks"), privateSpace(1), team(3, "Zebras")] }, // deliberately not in order
      "GET /api/notes": {
        body: [
          listNote("t1", 2, "Aardvarks", "Team plan"),
          listNote("p1", 1, "Private", "My diary", "dear diary", true),
        ],
      },
    });
    renderPage();
    const sections = await screen.findAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["Private", "Aardvarks", "Zebras"]);
    const space = within(sections[0]);
    expect(space.getByText(/only you can see these/)).toBeInTheDocument();
    expect(space.getByRole("link", { name: /My diary/ })).toHaveAttribute("href", "/notes/p1");
    expect(space.queryByText("Team plan")).not.toBeInTheDocument();
    expect(within(sections[1]).queryByText(/only you/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Create a team below to share/)).not.toBeInTheDocument(); // they already have one
  });

  it("New note in the private space creates it there", async () => {
    const fetchMock = mockApi({
      "GET /api/teams": { body: [privateSpace(7), team(2, "Alpha")] },
      "GET /api/notes": { body: [] },
      "POST /api/teams/7/notes": { status: 201, body: { id: "mine", teamId: 7, title: "Untitled" } },
    });
    renderPage();
    const space = within(await screen.findByRole("region", { name: "Private" }));
    await userEvent.click(space.getByRole("button", { name: "New note" }));
    expect(await screen.findByText("Opened note page")).toBeInTheDocument();
    expect(calledWith(fetchMock, "POST /api/teams/7/notes")).toBe(true);
    expect(calledWith(fetchMock, "POST /api/teams/2/notes")).toBe(false);
  });

  it("New note creates a note in that team and opens it", async () => {
    const fetchMock = mockApi({
      "GET /api/teams": { body: [team(1, "Alpha"), team(2, "Beta")] },
      "GET /api/notes": { body: [] },
      "POST /api/teams/2/notes": { status: 201, body: { id: "new-id", teamId: 2, title: "Untitled" } },
    });
    renderPage();
    const beta = within(await screen.findByRole("region", { name: "Beta" }));
    await userEvent.click(beta.getByRole("button", { name: "New note" }));
    expect(await screen.findByText("Opened note page")).toBeInTheDocument();
    expect(bodiesOf(fetchMock, "POST /api/teams/2/notes")).toEqual([{}]); // no title: the server names it
    expect(calledWith(fetchMock, "POST /api/teams/1/notes")).toBe(false);
  });

  it("creates a team and shows it", async () => {
    let created = false;
    const fetchMock = mockApi({
      "GET /api/teams": () => ({ body: created ? [team(5, "Gamma", "admin")] : [] }),
      "GET /api/notes": { body: [] },
      "POST /api/teams": () => {
        created = true;
        return { status: 201, body: team(5, "Gamma", "admin") };
      },
    });
    renderPage();
    await userEvent.type(await screen.findByLabelText("New team name"), "  Gamma ");
    await userEvent.click(screen.getByRole("button", { name: "Create team" }));
    expect(await screen.findByRole("region", { name: "Gamma" })).toBeInTheDocument();
    expect(bodiesOf(fetchMock, "POST /api/teams")).toEqual([{ name: "Gamma" }]);
    expect(screen.getByLabelText("New team name")).toHaveValue("");
  });

  it("will not create a team with a blank name", async () => {
    const fetchMock = mockApi({ "GET /api/teams": { body: [] }, "GET /api/notes": { body: [] } });
    renderPage();
    await userEvent.type(await screen.findByLabelText("New team name"), "   ");
    expect(screen.getByRole("button", { name: "Create team" })).toBeDisabled();
    expect(calledWith(fetchMock, "POST /api/teams")).toBe(false);
  });

  it("shows a server error instead of failing silently", async () => {
    mockApi({
      "GET /api/teams": { body: [team(1, "Alpha")] },
      "GET /api/notes": { body: [] },
      "POST /api/teams/1/notes": { status: 500, body: { error: "Internal server error" } },
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "New note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Internal server error");
    expect(screen.getByRole("button", { name: "New note" })).toBeEnabled(); // can try again
  });

  it("a failed first load can be retried", async () => {
    let healthy = false;
    mockApi({
      "GET /api/teams": () => (healthy ? { body: [team(1, "Alpha")] } : { status: 500, body: { error: "Internal server error" } }),
      "GET /api/notes": () => (healthy ? { body: [] } : { status: 500, body: { error: "Internal server error" } }),
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Internal server error");
    healthy = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports an ended session instead of showing an error", async () => {
    mockApi({ "GET /api/teams": { status: 401 }, "GET /api/notes": { status: 401 } });
    const { onSessionEnded } = renderPage();
    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
