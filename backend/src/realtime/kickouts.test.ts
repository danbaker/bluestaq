import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestServer } from "../testApp.js";

let ctx: Awaited<ReturnType<typeof setupTestServer>>;
beforeEach(async () => {
  ctx = await setupTestServer();
});
afterEach(async () => {
  await ctx.close();
});

const eventually = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 3000, interval: 20 });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** alice (admin) + bob on "Alpha" with one note; carol outside. */
async function world() {
  const alice = await ctx.as("alice");
  const bob = await ctx.as("bob");
  const carol = await ctx.as("carol");
  const teamId = (await alice.agent.post("/api/teams").send({ name: "Alpha" })).body.id as number;
  await alice.agent.post(`/api/teams/${teamId}/members`).send({ username: "bob" });
  const note = async (title = "N", team = teamId) =>
    (await alice.agent.post(`/api/teams/${team}/notes`).send({ title })).body.id as string;
  const memberId = async (name: string, team = teamId) =>
    (await alice.agent.get(`/api/teams/${team}/members`)).body.find((m: { username: string }) => m.username === name).userId as number;
  return { alice, bob, carol, teamId, noteId: await note(), note, memberId };
}

const presence = async (agent: { get: (p: string) => Promise<{ body: unknown; status: number }> }, noteId: string) =>
  (await agent.get(`/api/notes/${noteId}/presence`)).body;

describe("presence", () => {
  it("lists each user once with their tab count, and updates as tabs open and close", async () => {
    const { alice, bob, noteId } = await world();
    expect(await presence(alice.agent, noteId)).toEqual([]);

    const a1 = ctx.openNote(alice.cookie, noteId);
    const a2 = ctx.openNote(alice.cookie, noteId); // same user, second tab
    const b1 = ctx.openNote(bob.cookie, noteId);
    await Promise.all([a1.outcome, a2.outcome, b1.outcome]);

    await eventually(async () =>
      expect(await presence(bob.agent, noteId)).toEqual([
        { userId: expect.any(Number), username: "alice", tabs: 2 },
        { userId: expect.any(Number), username: "bob", tabs: 1 },
      ]),
    );

    a1.provider.destroy();
    await eventually(async () =>
      expect((await presence(bob.agent, noteId)).map((p: { username: string; tabs: number }) => [p.username, p.tabs])).toEqual([
        ["alice", 1],
        ["bob", 1],
      ]),
    );

    a2.provider.destroy();
    b1.provider.destroy();
    await eventually(async () => expect(await presence(alice.agent, noteId)).toEqual([]));
  });

  it("counts a tab for every note it has open, and only for those", async () => {
    const { alice, note, noteId } = await world();
    const second = await note("Second");
    const tab = ctx.openTab(alice.cookie);
    await Promise.all([ctx.openNote(alice.cookie, noteId, { socket: tab }).outcome, ctx.openNote(alice.cookie, second, { socket: tab }).outcome]);
    await eventually(async () => {
      expect(await presence(alice.agent, noteId)).toEqual([expect.objectContaining({ username: "alice", tabs: 1 })]);
      expect(await presence(alice.agent, second)).toEqual([expect.objectContaining({ username: "alice", tabs: 1 })]);
    });
    const third = await note("Third");
    expect(await presence(alice.agent, third)).toEqual([]);
  });

  it("does not list a tab whose request to open the note was refused", async () => {
    const { alice, carol, noteId } = await world();
    const a = ctx.openNote(alice.cookie, noteId);
    await a.outcome;
    expect(await ctx.openNote(carol.cookie, noteId).outcome).toBe("denied");
    await pause(100);
    expect((await presence(alice.agent, noteId)).map((p: { username: string }) => p.username)).toEqual(["alice"]);
  });

  it("is only visible to team members", async () => {
    const { carol, alice, noteId } = await world();
    expect((await carol.agent.get(`/api/notes/${noteId}/presence`)).status).toBe(404);
    expect((await alice.agent.get("/api/notes/00000000-0000-0000-0000-000000000000/presence")).status).toBe(404);
    expect((await alice.agent.get("/api/notes/nope/presence")).status).toBe(404);
  });
});

describe("logout closes every tab", () => {
  it("closes all of the user's sockets, and leaves other users' sockets open", async () => {
    const { alice, bob } = await world();
    const a1 = ctx.openSocket(alice.cookie);
    const a2 = ctx.openSocket(alice.cookie);
    const b1 = ctx.openSocket(bob.cookie);
    await Promise.all([a1.opened, a2.opened, b1.opened]);

    expect((await alice.agent.post("/api/auth/logout")).status).toBe(204);

    expect(await a1.closed).toMatchObject({ code: 4401 });
    expect(await a2.closed).toMatchObject({ code: 4401 });
    await pause(200);
    expect(b1.ws.readyState).toBe(b1.ws.OPEN);
  });

  it("a logout request with no valid session closes nothing", async () => {
    const { alice } = await world();
    const a1 = ctx.openSocket(alice.cookie);
    await a1.opened;
    const request = (await import("supertest")).default;
    expect((await request(ctx.server).post("/api/auth/logout")).status).toBe(204);
    await pause(200);
    expect(a1.ws.readyState).toBe(a1.ws.OPEN);
  });

  it("notes the user had open stop receiving edits", async () => {
    const { alice, bob, noteId } = await world();
    const a = ctx.openNote(alice.cookie, noteId);
    const b = ctx.openNote(bob.cookie, noteId);
    await Promise.all([a.outcome, b.outcome]);
    await alice.agent.post("/api/auth/logout");
    await eventually(async () => expect((await presence(bob.agent, noteId)).map((p: { username: string }) => p.username)).toEqual(["bob"]));
  });
});

describe("removing a member closes their notes on that team only", () => {
  async function setup() {
    const w = await world();
    // bob is also on a second team, with its own note, and has both notes open in ONE tab
    const betaId = (await w.bob.agent.post("/api/teams").send({ name: "Beta" })).body.id as number;
    await w.bob.agent.post(`/api/teams/${betaId}/members`).send({ username: "alice" });
    const betaNote = (await w.bob.agent.post(`/api/teams/${betaId}/notes`).send({ title: "Beta note" })).body.id as string;
    const tab = ctx.openTab(w.bob.cookie);
    const alpha = ctx.openNote(w.bob.cookie, w.noteId, { socket: tab });
    const beta = ctx.openNote(w.bob.cookie, betaNote, { socket: tab });
    await Promise.all([alpha.outcome, beta.outcome]);
    const alicesAlpha = ctx.openNote(w.alice.cookie, w.noteId);
    const alicesBeta = ctx.openNote(w.alice.cookie, betaNote);
    await Promise.all([alicesAlpha.outcome, alicesBeta.outcome]);
    await eventually(async () => expect(await presence(w.alice.agent, w.noteId)).toHaveLength(2));
    return { ...w, betaNote, alpha, beta, alicesAlpha, alicesBeta };
  }

  it("admin removes bob: his Alpha note closes immediately, his Beta note keeps working", async () => {
    const s = await setup();
    const bobId = await s.memberId("bob");
    expect((await s.alice.agent.delete(`/api/teams/${s.teamId}/members/${bobId}`)).status).toBe(204);

    // gone from Alpha's presence, still in Beta's
    await eventually(async () => expect((await presence(s.alice.agent, s.noteId)).map((p: { username: string }) => p.username)).toEqual(["alice"]));
    expect((await presence(s.alice.agent, s.betaNote)).map((p: { username: string }) => p.username)).toEqual(["alice", "bob"]);

    // Alpha edits no longer reach bob; Beta edits still do, over the very same socket
    s.alicesAlpha.text.insert(0, "secret alpha edit");
    s.alicesBeta.text.insert(0, "beta edit");
    await eventually(() => expect(s.beta.text.toString()).toBe("beta edit"));
    await pause(200);
    expect(s.alpha.text.toString()).toBe("");
  });

  it("a member who leaves by themselves is closed out the same way", async () => {
    const s = await setup();
    const bobId = await s.memberId("bob");
    expect((await s.bob.agent.delete(`/api/teams/${s.teamId}/members/${bobId}`)).status).toBe(204);
    await eventually(async () => expect((await presence(s.alice.agent, s.noteId)).map((p: { username: string }) => p.username)).toEqual(["alice"]));
    s.alicesAlpha.text.insert(0, "after bob left");
    await pause(200);
    expect(s.alpha.text.toString()).toBe("");
  });

  it("other members are not disturbed", async () => {
    const s = await setup();
    const bobId = await s.memberId("bob");
    await s.alice.agent.delete(`/api/teams/${s.teamId}/members/${bobId}`);
    await pause(100);
    const secondTab = ctx.openNote(s.alice.cookie, s.noteId); // a fresh tab proves the server still relays alice's edits
    await secondTab.outcome;
    s.alicesAlpha.text.insert(0, "alice keeps editing");
    await eventually(() => expect(secondTab.text.toString()).toBe("alice keeps editing"));
  });

  it("a refused removal (last admin) closes nothing", async () => {
    const s = await setup();
    const aliceId = await s.memberId("alice");
    expect((await s.alice.agent.delete(`/api/teams/${s.teamId}/members/${aliceId}`)).status).toBe(409);
    await pause(200);
    expect(await presence(s.bob.agent, s.noteId)).toHaveLength(2);
  });
});

describe("kick-outs cannot be dodged", () => {
  it("two connections to the same note inside one tab are both closed on removal, and count as one tab", async () => {
    const { alice, bob, teamId, noteId, memberId } = await world();
    const tab = ctx.openTab(bob.cookie);
    const editorOne = ctx.openNote(bob.cookie, noteId, { socket: tab, sessionAwareness: true }); // e.g. two editors on one page
    const editorTwo = ctx.openNote(bob.cookie, noteId, { socket: tab, sessionAwareness: true });
    expect(await Promise.all([editorOne.outcome, editorTwo.outcome])).toEqual(["allowed", "allowed"]);
    await eventually(async () =>
      expect(await presence(alice.agent, noteId)).toEqual([expect.objectContaining({ username: "bob", tabs: 1 })]),
    );

    // Closing one of them leaves bob present through the other.
    editorOne.provider.destroy();
    await pause(200);
    expect((await presence(alice.agent, noteId)).map((p: { username: string }) => p.username)).toEqual(["bob"]);

    await alice.agent.delete(`/api/teams/${teamId}/members/${await memberId("bob")}`);
    await eventually(async () => expect(await presence(alice.agent, noteId)).toEqual([]));
    const alicesTab = ctx.openNote(alice.cookie, noteId);
    await alicesTab.outcome;
    alicesTab.text.insert(0, "after removal");
    await pause(300);
    expect(editorTwo.text.toString()).toBe("");
  });

  it("someone removed while their note is still loading is closed as soon as it finishes", async () => {
    const { alice, bob, teamId, noteId, memberId } = await world();
    const bobId = await memberId("bob");
    // Slow down loading the note's saved content, so there is a window between "authorized" and "open".
    const realQuery = ctx.db.query.bind(ctx.db) as (sql: string, params?: unknown[]) => Promise<unknown>;
    vi.spyOn(ctx.db, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (/SELECT content FROM notes/.test(sql)) await pause(400);
      return realQuery(sql, params);
    }) as never);

    const opening = ctx.openNote(bob.cookie, noteId);
    await pause(150); // bob has been authorized; the load is in flight
    await alice.agent.delete(`/api/teams/${teamId}/members/${bobId}`);
    await opening.outcome.catch(() => {});
    await pause(800);
    vi.restoreAllMocks();

    expect(ctx.realtime.control.presence(noteId).map((p) => p.username)).not.toContain("bob");
    const alicesTab = ctx.openNote(alice.cookie, noteId);
    await alicesTab.outcome;
    alicesTab.text.insert(0, "after bob was removed");
    await pause(300);
    expect(opening.text.toString()).toBe("");
  });
});

describe("fails closed", () => {
  it("if the database errors during the access re-check after loading, the connection is closed, not left open", async () => {
    const { alice, bob, noteId } = await world(); // nobody has the note open, so bob's open has to load it

    // Opening a note authorizes, then loads it, then re-checks access. Fail the re-check, i.e. any role lookup after the load.
    const realQuery = ctx.db.query.bind(ctx.db) as (sql: string, params?: unknown[]) => Promise<unknown>;
    let loaded = false;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ctx.db, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (/SELECT content FROM notes/.test(sql)) loaded = true;
      if (loaded && /SELECT role FROM team_members/.test(sql)) throw new Error("database went away");
      return realQuery(sql, params);
    }) as never);

    const bobs = ctx.openNote(bob.cookie, noteId);
    await Promise.race([bobs.outcome, pause(1500)]);
    await pause(400);
    expect(loaded).toBe(true);
    expect(errorLog.mock.calls.some(([m]) => String(m).includes("closing it"))).toBe(true); // logged
    vi.restoreAllMocks();

    expect(ctx.realtime.control.presence(noteId).map((p) => p.username)).not.toContain("bob");
    const alices = ctx.openNote(alice.cookie, noteId);
    await alices.outcome;
    alices.text.insert(0, "anything");
    await pause(300);
    expect(bobs.text.toString()).toBe("");
  });
});

describe("deleting a note closes it for everyone", () => {
  it("disconnects all tabs on that note, and leaves their other notes alone", async () => {
    const { alice, bob, note, noteId } = await world();
    const other = await note("Other");
    const tab = ctx.openTab(bob.cookie);
    const doomedForBob = ctx.openNote(bob.cookie, noteId, { socket: tab });
    const otherForBob = ctx.openNote(bob.cookie, other, { socket: tab });
    const doomedForAlice = ctx.openNote(alice.cookie, noteId);
    const otherForAlice = ctx.openNote(alice.cookie, other);
    await Promise.all([doomedForBob.outcome, otherForBob.outcome, doomedForAlice.outcome, otherForAlice.outcome]);
    await eventually(() => expect(ctx.realtime.control.presence(noteId)).toHaveLength(2));

    expect((await bob.agent.delete(`/api/notes/${noteId}`)).status).toBe(204);

    await eventually(() => expect(ctx.realtime.control.presence(noteId)).toEqual([]));
    doomedForAlice.text.insert(0, "typing into a deleted note");
    await pause(200);
    expect(doomedForBob.text.toString()).toBe("");

    // the other note keeps syncing on the same sockets
    otherForAlice.text.insert(0, "still alive");
    await eventually(() => expect(otherForBob.text.toString()).toBe("still alive"));
  });
});

describe("login expiry closes the socket", () => {
  const userId = async (name: string) =>
    (await ctx.db.query<{ id: number }>("SELECT id FROM users WHERE username = $1", [name])).rows[0].id;

  it("closes at the moment the login runs out, not before", async () => {
    const short = ctx.openSocket(ctx.sessionCookieFor(await userId("alice"), undefined, 1));
    const long = ctx.openSocket(ctx.sessionCookieFor(await userId("alice"), undefined, 3600));
    await Promise.all([short.opened, long.opened]);
    expect(short.ws.readyState).toBe(short.ws.OPEN);

    expect(await Promise.race([short.closed, pause(3000).then(() => "still open")])).toMatchObject({ code: 4401 });
    expect(long.ws.readyState).toBe(long.ws.OPEN);
  });

  it("an expired session cannot connect at all", async () => {
    expect(await ctx.rawConnect({ cookie: ctx.sessionCookieFor(await userId("alice"), undefined, -5) })).toBe(401);
  });
});
