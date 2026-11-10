import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import { setupTestServer, TEST_ORIGIN } from "../testApp.js";

let ctx: Awaited<ReturnType<typeof setupTestServer>>;
beforeEach(async () => {
  ctx = await setupTestServer();
});
afterEach(async () => {
  await ctx.close();
});

const sync = <T>(fn: () => T) => vi.waitFor(fn, { timeout: 3000, interval: 20 });

/** alice (admin) + bob on "Alpha" with one note; carol outside. */
async function world() {
  const alice = await ctx.as("alice");
  const bob = await ctx.as("bob");
  const carol = await ctx.as("carol");
  const teamId = (await alice.agent.post("/api/teams").send({ name: "Alpha" })).body.id as number;
  await alice.agent.post(`/api/teams/${teamId}/members`).send({ username: "bob" });
  const note = async (title = "N") => (await alice.agent.post(`/api/teams/${teamId}/notes`).send({ title })).body.id as string;
  return { alice, bob, carol, teamId, noteId: await note(), note };
}

describe("socket handshake", () => {
  it("refuses a connection with no session cookie (401)", async () => {
    expect(await ctx.rawConnect()).toBe(401);
  });

  it("refuses garbage, wrongly-signed, and expired session cookies (401)", async () => {
    expect(await ctx.rawConnect({ cookie: "session=garbage" })).toBe(401);
    expect(await ctx.rawConnect({ cookie: ctx.sessionCookieFor(1, "another-secret") })).toBe(401);
    expect(await ctx.rawConnect({ cookie: ctx.sessionCookieFor(1, undefined, -10) })).toBe(401);
  });

  it("refuses a browser Origin that is not the app (403), even with a valid cookie", async () => {
    const { alice } = await world();
    expect(await ctx.rawConnect({ cookie: alice.cookie, origin: "http://evil.test" })).toBe(403);
  });

  it("accepts a valid cookie, with or without the allowed Origin", async () => {
    const { alice } = await world();
    expect(await ctx.rawConnect({ cookie: alice.cookie })).toBe("open");
    expect(await ctx.rawConnect({ cookie: alice.cookie, origin: TEST_ORIGIN })).toBe("open");
  });

  it("only serves /ws", async () => {
    const { alice } = await world();
    expect(await ctx.rawConnect({ cookie: alice.cookie, path: "/other" })).toBe(404);
  });
});

describe("hostile requests", () => {
  it("a malformed request target gets a 400 and does not crash the server", async () => {
    const { alice } = await world();
    const status = await new Promise<string>((resolve) => {
      const sock = net.connect(ctx.port, "127.0.0.1", () => {
        sock.write(
          "GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: ${alice.cookie}\r\n\r\n`,
        );
      });
      let buf = "";
      sock.on("data", (d) => (buf += d));
      sock.on("close", () => resolve(buf.split("\r\n")[0]));
      sock.on("error", () => {});
    });
    expect(status).toMatch(/ (400|404) /);
    // still alive, and still serving good connections
    expect(await ctx.rawConnect({ cookie: alice.cookie })).toBe("open");
  });
});

describe("per-note access", () => {
  it("lets a team member open the note", async () => {
    const { bob, noteId } = await world();
    expect(await ctx.openNote(bob.cookie, noteId).outcome).toBe("allowed");
  });

  it("refuses an outsider, even though their session is valid", async () => {
    const { carol, noteId } = await world();
    expect(await ctx.openNote(carol.cookie, noteId).outcome).toBe("denied");
  });

  it("refuses unknown, malformed, and non-canonical note ids the same way", async () => {
    const { alice, noteId } = await world();
    for (const name of [
      "00000000-0000-0000-0000-000000000000",
      "not-a-uuid",
      "1; drop table notes",
      noteId.toUpperCase(),
    ]) {
      expect(await ctx.openNote(alice.cookie, name).outcome).toBe("denied");
    }
  });

  it("an outsider never receives the note's content", async () => {
    const { alice, carol, noteId } = await world();
    const a = ctx.openNote(alice.cookie, noteId);
    await a.outcome;
    a.text.insert(0, "top secret");
    const c = ctx.openNote(carol.cookie, noteId);
    expect(await c.outcome).toBe("denied");
    await new Promise((r) => setTimeout(r, 200));
    expect(c.text.toString()).toBe("");
  });

  it("a removed member is refused when they open the note afterwards", async () => {
    const { alice, bob, teamId, noteId } = await world();
    const bobId = (await alice.agent.get(`/api/teams/${teamId}/members`)).body.find(
      (m: { username: string }) => m.username === "bob",
    ).userId;
    expect(await ctx.openNote(bob.cookie, noteId).outcome).toBe("allowed");
    await alice.agent.delete(`/api/teams/${teamId}/members/${bobId}`);
    expect(await ctx.openNote(bob.cookie, noteId).outcome).toBe("denied");
  });
});

describe("live sync", () => {
  it("an edit by one user appears for another", async () => {
    const { alice, bob, noteId } = await world();
    const a = ctx.openNote(alice.cookie, noteId);
    const b = ctx.openNote(bob.cookie, noteId);
    await Promise.all([a.outcome, b.outcome]);
    a.text.insert(0, "hello from alice");
    await sync(() => expect(b.text.toString()).toBe("hello from alice"));
    b.text.insert(b.text.length, "!");
    await sync(() => expect(a.text.toString()).toBe("hello from alice!"));
  });

  it("someone who opens later gets what was already typed", async () => {
    const { alice, bob, noteId } = await world();
    const a = ctx.openNote(alice.cookie, noteId);
    await a.outcome;
    a.text.insert(0, "written before bob arrived");
    await sync(() => expect(a.provider.hasUnsyncedChanges).toBe(false));
    const b = ctx.openNote(bob.cookie, noteId);
    await b.outcome;
    await sync(() => expect(b.text.toString()).toBe("written before bob arrived"));
  });

  it("simultaneous edits from two users both survive and converge", async () => {
    const { alice, bob, noteId } = await world();
    const a = ctx.openNote(alice.cookie, noteId);
    const b = ctx.openNote(bob.cookie, noteId);
    await Promise.all([a.outcome, b.outcome]);
    a.text.insert(0, "AAA");
    b.text.insert(0, "BBB");
    await sync(() => {
      expect(a.text.length).toBe(6);
      expect(a.text.toString()).toBe(b.text.toString());
    });
    expect(a.text.toString()).toContain("AAA");
    expect(a.text.toString()).toContain("BBB");
  });

  it("edits to one note never show up in another", async () => {
    const { alice, bob, note, noteId } = await world();
    const other = await note("Other");
    const a1 = ctx.openNote(alice.cookie, noteId);
    const b2 = ctx.openNote(bob.cookie, other);
    await Promise.all([a1.outcome, b2.outcome]);
    a1.text.insert(0, "only in note one");
    await new Promise((r) => setTimeout(r, 300));
    expect(b2.text.toString()).toBe("");
  });
});

describe("same user, several tabs", () => {
  it("one user with the same note open in two tabs: each tab sees the other's edits", async () => {
    const { alice, bob, noteId } = await world();
    const tab1 = ctx.openNote(alice.cookie, noteId); // each openNote() without a shared socket = its own tab
    const tab2 = ctx.openNote(alice.cookie, noteId);
    const other = ctx.openNote(bob.cookie, noteId);
    await Promise.all([tab1.outcome, tab2.outcome, other.outcome]);

    tab1.text.insert(0, "typed in tab 1");
    await sync(() => {
      expect(tab2.text.toString()).toBe("typed in tab 1");
      expect(other.text.toString()).toBe("typed in tab 1");
    });
    tab2.text.insert(tab2.text.length, " + tab 2");
    await sync(() => expect(tab1.text.toString()).toBe("typed in tab 1 + tab 2"));
  });

  it("closing one tab leaves the other tab (and the note) working", async () => {
    const { alice, bob, noteId } = await world();
    const tab1 = ctx.openNote(alice.cookie, noteId);
    const tab2 = ctx.openNote(alice.cookie, noteId);
    const other = ctx.openNote(bob.cookie, noteId);
    await Promise.all([tab1.outcome, tab2.outcome, other.outcome]);
    tab1.provider.destroy();
    tab2.text.insert(0, "still here");
    await sync(() => expect(other.text.toString()).toBe("still here"));
  });

  it("one tab can carry several notes, and a refused note does not affect the others", async () => {
    const { alice, carol, bob, note, noteId } = await world();
    const second = await note("Second");
    // carol's own team and note: alice is not a member
    const carolTeam = (await carol.agent.post("/api/teams").send({ name: "Gamma" })).body.id as number;
    const forbidden = (await carol.agent.post(`/api/teams/${carolTeam}/notes`).send({ title: "Not yours" })).body.id as string;

    const tab = ctx.openTab(alice.cookie);
    const n1 = ctx.openNote(alice.cookie, noteId, { socket: tab });
    const n2 = ctx.openNote(alice.cookie, second, { socket: tab });
    const n3 = ctx.openNote(alice.cookie, forbidden, { socket: tab });
    expect(await Promise.all([n1.outcome, n2.outcome, n3.outcome])).toEqual(["allowed", "allowed", "denied"]);

    const bobOnFirst = ctx.openNote(bob.cookie, noteId);
    await bobOnFirst.outcome;
    n1.text.insert(0, "via the shared tab");
    await sync(() => expect(bobOnFirst.text.toString()).toBe("via the shared tab"));
    expect(n3.text.toString()).toBe("");
  });
});

describe("heartbeat", () => {
  async function connectWith(autoPong: boolean) {
    const alice = await ctx.as("alice");
    const ws = new WebSocket(ctx.wsUrl, { headers: { Cookie: alice.cookie }, autoPong });
    ws.on("error", () => {});
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    return { ws, closed };
  }

  it("drops a socket that stops answering pings, but keeps a healthy one", async () => {
    await ctx.close();
    ctx = await setupTestServer({ heartbeatMs: 100 });
    const dead = await connectWith(false);
    const healthy = await connectWith(true);
    await Promise.race([dead.closed, new Promise((_, rej) => setTimeout(() => rej(new Error("dead socket never dropped")), 2000))]);
    expect(dead.ws.readyState).toBe(WebSocket.CLOSED);
    await new Promise((r) => setTimeout(r, 400)); // several more heartbeats
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
    healthy.ws.close();
  });
});
