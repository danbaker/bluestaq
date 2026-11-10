// Runs on REAL Postgres (database "bluestaq_test_realtime"): pg-mem corrupts bytea data. Skips if Postgres is down.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { connectRealTestDb } from "../db/testDb.js";
import { setupTestServer } from "../testApp.js";
import { BODY_FIELD, extractText } from "./noteText.js";

const pool = await connectRealTestDb("bluestaq_test_realtime");

let ctx: Awaited<ReturnType<typeof setupTestServer>>;
afterEach(async () => {
  vi.restoreAllMocks(); // the pool is shared by every test in this file; never leak a spy
  await ctx?.close();
});
afterAll(async () => {
  await pool?.end();
});

const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 3000, interval: 20 });

/** Adds a paragraph the way the Tiptap editor stores one: <paragraph>text</paragraph> in the "default" fragment. */
function addParagraph(doc: Y.Doc, text: string) {
  const fragment = doc.getXmlFragment(BODY_FIELD);
  const paragraph = new Y.XmlElement("paragraph");
  fragment.insert(fragment.length, [paragraph]);
  const run = new Y.XmlText();
  paragraph.insert(0, [run]);
  run.insert(0, text);
}

async function world(opts: Parameters<typeof setupTestServer>[0] = {}) {
  ctx = await setupTestServer({ ...opts, realDb: pool! });
  const alice = await ctx.as("alice");
  const bob = await ctx.as("bob");
  const teamId = (await alice.agent.post("/api/teams").send({ name: "Alpha" })).body.id as number;
  await alice.agent.post(`/api/teams/${teamId}/members`).send({ username: "bob" });
  const noteId = (await alice.agent.post(`/api/teams/${teamId}/notes`).send({ title: "N" })).body.id as string;
  const row = async () => (await ctx.db.query("SELECT content, text, updated_at FROM notes WHERE id = $1", [noteId])).rows[0];
  return { alice, bob, noteId, teamId, row };
}

describe.skipIf(!pool)("saving and loading", () => {
  it("content survives everyone leaving: reopening the note shows what was typed", async () => {
    const { alice, noteId } = await world();
    const first = ctx.openNote(alice.cookie, noteId);
    await first.outcome;
    addParagraph(first.doc, "remember the milk");
    await waitFor(() => expect(first.provider.hasUnsyncedChanges).toBe(false));
    first.provider.destroy(); // last tab closes -> saved

    const second = ctx.openNote(alice.cookie, noteId);
    await second.outcome;
    await waitFor(() => expect(extractText(second.doc)).toBe("remember the milk"));
  });

  it("saves while people are still typing, after a short pause", async () => {
    const { alice, row, noteId } = await world();
    const tab = ctx.openNote(alice.cookie, noteId);
    await tab.outcome;
    addParagraph(tab.doc, "autosaved");
    await waitFor(async () => expect((await row()).text).toBe("autosaved")); // tab still open
  });

  it("keeps a plain-text copy: lines per paragraph, shown in the REST detail and list preview", async () => {
    const { alice, noteId, teamId } = await world();
    const tab = ctx.openNote(alice.cookie, noteId);
    await tab.outcome;
    addParagraph(tab.doc, "first line");
    addParagraph(tab.doc, "second line");
    await waitFor(async () => {
      const got = await alice.agent.get(`/api/notes/${noteId}`);
      expect(got.body.text).toBe("first line\nsecond line");
    });
    const [item] = (await alice.agent.get(`/api/teams/${teamId}/notes`)).body;
    expect(item.preview).toBe("first line\nsecond line");
  });

  it("bumps the note to the top of the list when it is edited", async () => {
    const { alice, noteId, teamId } = await world();
    const newer = (await alice.agent.post(`/api/teams/${teamId}/notes`).send({ title: "Newer" })).body.id;
    expect((await alice.agent.get(`/api/teams/${teamId}/notes`)).body[0].id).toBe(newer);
    const tab = ctx.openNote(alice.cookie, noteId);
    await tab.outcome;
    addParagraph(tab.doc, "edit");
    await waitFor(async () => expect((await alice.agent.get(`/api/teams/${teamId}/notes`)).body[0].id).toBe(noteId));
  });

  it("another user's edits are saved and visible to a teammate who opens later", async () => {
    const { alice, bob, noteId } = await world();
    const a = ctx.openNote(alice.cookie, noteId);
    await a.outcome;
    addParagraph(a.doc, "from alice");
    await waitFor(() => expect(a.provider.hasUnsyncedChanges).toBe(false));
    a.provider.destroy();
    const b = ctx.openNote(bob.cookie, noteId);
    await b.outcome;
    await waitFor(() => expect(extractText(b.doc)).toBe("from alice"));
    addParagraph(b.doc, "and bob");
    await waitFor(() => expect(b.provider.hasUnsyncedChanges).toBe(false));
    b.provider.destroy();
    const c = ctx.openNote(alice.cookie, noteId);
    await c.outcome;
    await waitFor(() => expect(extractText(c.doc)).toBe("from alice\nand bob"));
  });

  it("opening a note without editing it writes nothing and does not change its timestamp", async () => {
    const { alice, noteId, row } = await world();
    const before = (await row()).updated_at;
    const querySpy = vi.spyOn(ctx.db, "query");
    const tab = ctx.openNote(alice.cookie, noteId);
    await tab.outcome;
    await new Promise((r) => setTimeout(r, 200));
    tab.provider.destroy();
    await new Promise((r) => setTimeout(r, 200));
    const writes = querySpy.mock.calls.filter(([sql]) => /UPDATE notes SET content/.test(String(sql)));
    expect(writes).toHaveLength(0);
    expect(new Date((await row()).updated_at).getTime()).toBe(new Date(before).getTime());
  });

  it("two tabs editing the same note produce one save, not one per tab", async () => {
    const { alice, noteId } = await world({ saveDelayMs: 100 });
    const tab1 = ctx.openNote(alice.cookie, noteId);
    const tab2 = ctx.openNote(alice.cookie, noteId);
    await Promise.all([tab1.outcome, tab2.outcome]);
    const querySpy = vi.spyOn(ctx.db, "query");
    addParagraph(tab1.doc, "one");
    addParagraph(tab2.doc, "two");
    await waitFor(() => expect(tab1.provider.hasUnsyncedChanges || tab2.provider.hasUnsyncedChanges).toBe(false));
    tab1.provider.destroy();
    tab2.provider.destroy();
    await new Promise((r) => setTimeout(r, 400));
    const writes = querySpy.mock.calls.filter(([sql]) => /UPDATE notes SET content/.test(String(sql)));
    expect(writes).toHaveLength(1);
  });

  it("stores the body in the 'default' field only; other fields still sync and reload but add no plain text", async () => {
    const { alice, noteId, row } = await world();
    const tab = ctx.openNote(alice.cookie, noteId);
    await tab.outcome;
    tab.text.insert(0, "in another field"); // doc.getText("content")
    await waitFor(async () => expect((await row()).content).not.toBeNull());
    expect((await row()).text).toBe("");
    tab.provider.destroy();
    const again = ctx.openNote(alice.cookie, noteId);
    await again.outcome;
    await waitFor(() => expect(again.text.toString()).toBe("in another field"));
  });
});

describe.skipIf(!pool)("shutdown and restart", () => {
  it("edits made just before shutdown are saved, even before the save delay has passed", async () => {
    const { alice, noteId, row } = await world({ saveDelayMs: 60_000 });
    const tab = ctx.openNote(alice.cookie, noteId);
    await tab.outcome;
    addParagraph(tab.doc, "typed right before shutdown");
    await waitFor(() => expect(tab.provider.hasUnsyncedChanges).toBe(false));
    expect((await row()).text).toBe(""); // not saved yet: the 60s delay is far away

    // Make the database slow, so shutdown only gets the text saved if it really waits for the write.
    const realQuery = ctx.db.query.bind(ctx.db) as (sql: string, params?: unknown[]) => Promise<unknown>;
    vi.spyOn(ctx.db, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (/UPDATE notes SET content/.test(sql)) await new Promise((r) => setTimeout(r, 300));
      return realQuery(sql, params);
    }) as never);

    await ctx.restart(); // like SIGTERM: flushes pending saves
    vi.restoreAllMocks(); // the assertion below must read the real database
    expect((await row()).text).toBe("typed right before shutdown");
  });

  it("after a restart the note opens with its saved content", async () => {
    const { alice, noteId } = await world();
    const tab = ctx.openNote(alice.cookie, noteId);
    await tab.outcome;
    addParagraph(tab.doc, "survives restarts");
    await waitFor(() => expect(tab.provider.hasUnsyncedChanges).toBe(false));
    await ctx.restart();
    const fresh = await ctx.as("alice");
    const reopened = ctx.openNote(fresh.cookie, noteId);
    expect(await reopened.outcome).toBe("allowed");
    await waitFor(() => expect(extractText(reopened.doc)).toBe("survives restarts"));
  });
});

describe.skipIf(!pool)("edge cases", () => {
  it("a note whose saved content is unreadable refuses to open and its data is left untouched", async () => {
    const { alice, noteId, row } = await world();
    const garbage = Buffer.from([255, 254, 253, 252, 251, 250, 249]);
    await ctx.db.query("UPDATE notes SET content = $2, text = 'old text' WHERE id = $1", [noteId, garbage]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const tab = ctx.openNote(alice.cookie, noteId);
    await Promise.race([tab.outcome, new Promise((r) => setTimeout(r, 500))]);
    tab.text.insert(0, "this must not overwrite anything");
    await new Promise((r) => setTimeout(r, 400));
    tab.provider.destroy();
    await new Promise((r) => setTimeout(r, 200));

    const after = await row();
    expect(Buffer.compare(after.content, garbage)).toBe(0);
    expect(after.text).toBe("old text");
    expect(errorLog.mock.calls.some(([m]) => String(m).includes(noteId))).toBe(true); // logged with the note id
    errorLog.mockRestore();
    expect(await ctx.rawConnect({ cookie: alice.cookie })).toBe("open"); // server still healthy
  });

  it("editing a note that was deleted meanwhile does not crash or bring it back", async () => {
    const { alice, noteId } = await world({ saveDelayMs: 100 });
    const tab = ctx.openNote(alice.cookie, noteId);
    await tab.outcome;
    await alice.agent.delete(`/api/notes/${noteId}`);
    addParagraph(tab.doc, "typing into a deleted note");
    await new Promise((r) => setTimeout(r, 400));
    tab.provider.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect((await ctx.db.query("SELECT 1 FROM notes WHERE id = $1", [noteId])).rows).toHaveLength(0);
    expect(await ctx.rawConnect({ cookie: alice.cookie })).toBe("open"); // server still healthy
  });
});
