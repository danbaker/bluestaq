import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import NoteEditor from "./NoteEditor";
import { mockApi } from "./testUtils";

// Stand-ins for the network and the rich-text widget, so the test can drive the connection by hand.
interface Config {
  url: string;
  name: string;
  token: string;
  document: unknown;
  onStatus: (e: { status: string }) => void;
  onAuthenticationFailed: () => void;
  onClose: () => void;
}
const providers = vi.hoisted(() => [] as { config: Config; destroy: ReturnType<typeof vi.fn> }[]);

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    destroy = vi.fn();
    constructor(config: Config) {
      providers.push({ config, destroy: this.destroy });
    }
  },
}));
vi.mock("@tiptap/react", () => ({
  useEditor: () => null,
  EditorContent: () => <div data-testid="editor-surface" />,
}));

beforeEach(() => {
  providers.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

const noop = () => {};
const last = () => providers[providers.length - 1];
const renderEditor = (props: Partial<React.ComponentProps<typeof NoteEditor>> = {}) =>
  render(<NoteEditor noteId="note-1" onAccessLost={noop} onSessionEnded={noop} {...props} />);

describe("NoteEditor connection", () => {
  it("joins the live document for this note, through the same host as the page", async () => {
    renderEditor();
    expect(providers).toHaveLength(1);
    expect(last().config.name).toBe("note-1");
    expect(last().config.url).toBe(`ws://${window.location.host}/ws`);
    expect(last().config.token).toBeTruthy(); // the library needs some value; the server uses the login cookie
    expect(await screen.findByTestId("editor-surface")).toBeInTheDocument();
  });

  it("uses a secure socket when the page is secure", () => {
    const original = window.location;
    vi.stubGlobal("location", { ...original, protocol: "https:", host: "notes.example.com" });
    renderEditor();
    expect(last().config.url).toBe("wss://notes.example.com/ws");
  });

  it("shows connecting, then live, then offline as the connection changes", () => {
    renderEditor();
    expect(screen.getByRole("status")).toHaveTextContent("Connecting");
    act(() => last().config.onStatus({ status: "connected" }));
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    act(() => last().config.onStatus({ status: "disconnected" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Offline.*kept.*sync/);
    act(() => last().config.onStatus({ status: "connecting" }));
    expect(screen.getByRole("status")).toHaveTextContent("Connecting");
  });

  it("disconnects when the page is left, and reconnects fresh when the note changes", () => {
    const { unmount, rerender } = renderEditor();
    const first = last();
    rerender(<NoteEditor noteId="note-2" onAccessLost={noop} onSessionEnded={noop} />);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(providers).toHaveLength(2);
    expect(last().config.name).toBe("note-2");
    unmount();
    expect(last().destroy).toHaveBeenCalledTimes(1);
  });

  it("each note gets its own document, never reused", () => {
    const { rerender } = renderEditor();
    const firstDoc = last().config.document;
    rerender(<NoteEditor noteId="note-2" onAccessLost={noop} onSessionEnded={noop} />);
    expect(last().config.document).not.toBe(firstDoc);
  });
});

describe("NoteEditor when the server closes the note", () => {
  it("refused when opening (no access, or deleted): tells the page access was lost", () => {
    const onAccessLost = vi.fn();
    renderEditor({ onAccessLost });
    act(() => last().config.onAuthenticationFailed());
    expect(onAccessLost).toHaveBeenCalledTimes(1);
  });

  it("closed while open and the note is now gone (404): tells the page access was lost", async () => {
    mockApi({ "GET /api/notes/note-1": { status: 404, body: { error: "Note not found" } } });
    const onAccessLost = vi.fn();
    const onSessionEnded = vi.fn();
    renderEditor({ onAccessLost, onSessionEnded });
    act(() => last().config.onClose());
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledTimes(1));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it("closed while open and the login has ended (401): tells the app the session ended", async () => {
    mockApi({ "GET /api/notes/note-1": { status: 401, body: { error: "Unauthorized" } } });
    const onAccessLost = vi.fn();
    const onSessionEnded = vi.fn();
    renderEditor({ onAccessLost, onSessionEnded });
    act(() => last().config.onClose());
    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledTimes(1));
    expect(onAccessLost).not.toHaveBeenCalled();
  });

  it("closed by a network blip (the note is still there): does nothing, the library reconnects", async () => {
    const fetchMock = mockApi({ "GET /api/notes/note-1": { body: { id: "note-1" } } });
    const onAccessLost = vi.fn();
    const onSessionEnded = vi.fn();
    renderEditor({ onAccessLost, onSessionEnded });
    act(() => last().config.onClose());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(onAccessLost).not.toHaveBeenCalled();
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it("closed while the server itself is unreachable: does nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const onAccessLost = vi.fn();
    const onSessionEnded = vi.fn();
    renderEditor({ onAccessLost, onSessionEnded });
    act(() => last().config.onClose());
    await new Promise((r) => setTimeout(r, 30));
    expect(onAccessLost).not.toHaveBeenCalled();
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it("a late answer after leaving the note is ignored (no false 'deleted' message on the next note)", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const onAccessLost = vi.fn();
    const { rerender } = renderEditor({ onAccessLost });
    act(() => last().config.onClose()); // note 1's connection closed; the check is in flight...
    rerender(<NoteEditor noteId="note-2" onAccessLost={onAccessLost} onSessionEnded={noop} />); // ...and we move on
    await act(async () => answer({ ok: false, status: 404, json: async () => ({ error: "Note not found" }) } as Response));
    await new Promise((r) => setTimeout(r, 30));
    expect(onAccessLost).not.toHaveBeenCalled();
  });

  it("repeated closes from a failing reconnect trigger one check at a time", async () => {
    let answer!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();
    act(() => {
      last().config.onClose();
      last().config.onClose();
      last().config.onClose();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ok: true, status: 200, json: async () => ({}) } as Response));
    act(() => last().config.onClose()); // once the first check is done, a new close is checked again
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the parent's latest callbacks, not stale ones from first render", async () => {
    mockApi({ "GET /api/notes/note-1": { status: 404 } });
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = renderEditor({ onAccessLost: stale });
    rerender(<NoteEditor noteId="note-1" onAccessLost={fresh} onSessionEnded={noop} />);
    expect(providers).toHaveLength(1); // same connection: no reconnect just because a callback changed
    act(() => last().config.onClose());
    await vi.waitFor(() => expect(fresh).toHaveBeenCalledTimes(1));
    expect(stale).not.toHaveBeenCalled();
  });
});
