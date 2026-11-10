import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, it, expect, vi } from "vitest";
import NotePage from "./NotePage";
import { bodiesOf, calledWith, mockApi, team } from "./testUtils";

// The live editor has its own tests. Here it is a stand-in whose "events" the test can trigger.
const editor = vi.hoisted(() => ({ props: null as null | { noteId: string; onAccessLost: () => void; onSessionEnded: () => void } }));
vi.mock("./NoteEditor", () => ({
  default: (props: { noteId: string; onAccessLost: () => void; onSessionEnded: () => void }) => {
    editor.props = props;
    return <div data-testid="editor">editor for {props.noteId}</div>;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  editor.props = null;
});

const NOTE = { id: "n1", teamId: 1, title: "Standup", updatedAt: "2026-11-10T12:00:00.000Z" };

function renderPage(onSessionEnded = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/notes/n1"]}>
      <Routes>
        <Route path="/" element={<p>Notes list page</p>} />
        <Route
          path="/notes/:id"
          element={
            <>
              <Link to="/notes/n2">go to second note</Link>
              <NotePage onSessionEnded={onSessionEnded} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onSessionEnded };
}

const loadedRoutes = {
  "GET /api/notes/n1": { body: NOTE },
  "GET /api/teams": { body: [team(1, "Alpha")] },
};

describe("NotePage", () => {
  it("shows the title, the team, and the live editor for this note", async () => {
    mockApi(loadedRoutes);
    renderPage();
    expect(await screen.findByLabelText("Note title")).toHaveValue("Standup");
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByTestId("editor")).toHaveTextContent("editor for n1");
    expect(screen.getByRole("link", { name: /All notes/ })).toHaveAttribute("href", "/");
  });

  it("renames on Enter and on blur, sending the trimmed title", async () => {
    const fetchMock = mockApi({
      ...loadedRoutes,
      "PATCH /api/notes/n1": ({ body }) => ({ body: { ...NOTE, title: (body as { title: string }).title } }),
    });
    renderPage();
    const title = await screen.findByLabelText("Note title");
    await userEvent.clear(title);
    await userEvent.type(title, "  Weekly sync  {Enter}");
    await vi.waitFor(() => expect(bodiesOf(fetchMock, "PATCH /api/notes/n1")).toEqual([{ title: "Weekly sync" }]));
    expect(title).toHaveValue("Weekly sync");

    await userEvent.clear(title);
    await userEvent.type(title, "Final name");
    await userEvent.tab(); // blur
    await vi.waitFor(() => expect(bodiesOf(fetchMock, "PATCH /api/notes/n1")).toHaveLength(2));
    expect(bodiesOf(fetchMock, "PATCH /api/notes/n1")[1]).toEqual({ title: "Final name" });
  });

  it("does not save an unchanged or empty title, and puts the old one back", async () => {
    const fetchMock = mockApi(loadedRoutes);
    renderPage();
    const title = await screen.findByLabelText("Note title");
    await userEvent.click(title);
    await userEvent.tab(); // unchanged
    await userEvent.clear(title);
    await userEvent.tab(); // empty
    expect(calledWith(fetchMock, "PATCH /api/notes/n1")).toBe(false);
    expect(title).toHaveValue("Standup");
  });

  it("shows the server's message and restores the title when renaming fails", async () => {
    mockApi({ ...loadedRoutes, "PATCH /api/notes/n1": { status: 404, body: { error: "Note not found" } } });
    renderPage();
    const title = await screen.findByLabelText("Note title");
    await userEvent.clear(title);
    await userEvent.type(title, "New{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Note not found");
    expect(title).toHaveValue("Standup");
  });

  it("delete asks first, then deletes and returns to the list", async () => {
    const fetchMock = mockApi({ ...loadedRoutes, "DELETE /api/notes/n1": { status: 204 } });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Delete note" }));
    expect(screen.getByText(/Delete this note for everyone on Alpha\?/)).toBeInTheDocument();
    expect(calledWith(fetchMock, "DELETE /api/notes/n1")).toBe(false); // nothing happens until confirmed
    await userEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(await screen.findByText("Notes list page")).toBeInTheDocument();
    expect(calledWith(fetchMock, "DELETE /api/notes/n1")).toBe(true);
  });

  it("cancelling the delete keeps the note", async () => {
    const fetchMock = mockApi({ ...loadedRoutes, "DELETE /api/notes/n1": { status: 204 } });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Delete note" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete note" })).toBeInTheDocument();
    expect(calledWith(fetchMock, "DELETE /api/notes/n1")).toBe(false);
  });

  it("a failed delete shows the error and stays on the note", async () => {
    mockApi({ ...loadedRoutes, "DELETE /api/notes/n1": { status: 500, body: { error: "Internal server error" } } });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Delete note" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Internal server error");
    expect(screen.getByLabelText("Note title")).toBeInTheDocument();
  });

  it("moving to another note drops a half-finished delete and an old error, so 'Yes, delete' can't hit the wrong note", async () => {
    const fetchMock = mockApi({
      ...loadedRoutes,
      "GET /api/notes/n2": { body: { ...NOTE, id: "n2", title: "Second" } },
      "PATCH /api/notes/n1": { status: 500, body: { error: "Internal server error" } },
      "DELETE /api/notes/n1": { status: 204 },
      "DELETE /api/notes/n2": { status: 204 },
    });
    renderPage();
    const title = await screen.findByLabelText("Note title");
    await userEvent.clear(title);
    await userEvent.type(title, "x{Enter}");
    expect(await screen.findByRole("alert")).toBeInTheDocument(); // an error from note 1
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(screen.getByRole("button", { name: "Yes, delete" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "go to second note" }));
    expect(await screen.findByDisplayValue("Second")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calledWith(fetchMock, "DELETE /api/notes/n2")).toBe(false);
  });

  it("the note still opens when only the team-name lookup fails", async () => {
    mockApi({ "GET /api/notes/n1": { body: NOTE }, "GET /api/teams": { status: 500, body: { error: "Internal server error" } } });
    renderPage();
    expect(await screen.findByLabelText("Note title")).toHaveValue("Standup");
    expect(screen.getByTestId("editor")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Enter while composing text (IME) does not save the half-typed title", async () => {
    const fetchMock = mockApi({ ...loadedRoutes, "PATCH /api/notes/n1": { body: NOTE } });
    renderPage();
    const title = await screen.findByLabelText("Note title");
    await userEvent.clear(title);
    await userEvent.type(title, "にほん");
    fireEvent.keyDown(title, { key: "Enter", isComposing: true });
    expect(title).toHaveFocus();
    expect(calledWith(fetchMock, "PATCH /api/notes/n1")).toBe(false);
    fireEvent.keyDown(title, { key: "Enter" }); // a real Enter still saves
    await vi.waitFor(() => expect(calledWith(fetchMock, "PATCH /api/notes/n1")).toBe(true));
  });

  it("a missing or forbidden note shows a message with a way back, and no editor", async () => {
    mockApi({ "GET /api/notes/n1": { status: 404, body: { error: "Note not found" } }, "GET /api/teams": { body: [] } });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/deleted, or you no longer have access/);
    expect(screen.getByRole("link", { name: /All notes/ })).toBeInTheDocument();
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
  });

  it("when the live editor says access was lost (deleted by someone else), the editor goes away", async () => {
    mockApi(loadedRoutes);
    renderPage();
    await screen.findByTestId("editor");
    act(() => editor.props!.onAccessLost());
    expect(await screen.findByRole("alert")).toHaveTextContent(/deleted, or you no longer have access/);
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
  });

  it("when the live editor says the session ended, the app is told", async () => {
    mockApi(loadedRoutes);
    const { onSessionEnded } = renderPage();
    await screen.findByTestId("editor");
    act(() => editor.props!.onSessionEnded());
    expect(onSessionEnded).toHaveBeenCalled();
  });

  it("an ended session while loading is reported, not shown as an error", async () => {
    mockApi({ "GET /api/notes/n1": { status: 401 }, "GET /api/teams": { status: 401 } });
    const { onSessionEnded } = renderPage();
    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("other load failures show their message", async () => {
    mockApi({ "GET /api/notes/n1": { status: 500, body: { error: "Internal server error" } }, "GET /api/teams": { body: [] } });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Internal server error");
  });
});
