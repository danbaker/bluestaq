import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { setupTestApp } from "../testApp.js";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeEach(async () => {
  ctx = await setupTestApp();
});

const tick = () => new Promise((r) => setTimeout(r, 5)); // distinct timestamps for ordering tests

/** alice admin of "Alpha", bob a member, carol outside. */
async function world() {
  const alice = await ctx.as("alice");
  const teamId = (await alice.post("/api/teams").send({ name: "Alpha" })).body.id as number;
  await alice.post(`/api/teams/${teamId}/members`).send({ username: "bob" });
  const bob = await ctx.as("bob");
  const carol = await ctx.as("carol");
  return { alice, bob, carol, teamId };
}

describe("auth required", () => {
  it.each([
    ["get", "/api/teams/1/notes"],
    ["post", "/api/teams/1/notes"],
    ["get", "/api/notes/2f1c1c1e-6a0b-4b7a-9d57-0f5f3f8a1b11"],
    ["patch", "/api/notes/2f1c1c1e-6a0b-4b7a-9d57-0f5f3f8a1b11"],
    ["delete", "/api/notes/2f1c1c1e-6a0b-4b7a-9d57-0f5f3f8a1b11"],
  ] as const)("%s %s returns 401 when logged out", async (method, path) => {
    expect((await request(ctx.app)[method](path)).status).toBe(401);
  });
});

describe("create and read", () => {
  it("a member creates a note, then reads it", async () => {
    const { bob, teamId } = await world();
    const res = await bob.post(`/api/teams/${teamId}/notes`).send({ title: "  Standup  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ teamId, title: "Standup", text: "" });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.createdBy).toEqual(expect.any(Number));

    const got = await bob.get(`/api/notes/${res.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(res.body);
  });

  it("title is optional and defaults to Untitled; blank also becomes Untitled", async () => {
    const { alice, teamId } = await world();
    expect((await alice.post(`/api/teams/${teamId}/notes`).send({})).body.title).toBe("Untitled");
    expect((await alice.post(`/api/teams/${teamId}/notes`).send({ title: "   " })).body.title).toBe("Untitled");
  });

  it("counts characters, not UTF-16 units: 200 emoji is allowed, 201 is not", async () => {
    const { alice, teamId } = await world();
    expect((await alice.post(`/api/teams/${teamId}/notes`).send({ title: "😀".repeat(200) })).status).toBe(201);
    expect((await alice.post(`/api/teams/${teamId}/notes`).send({ title: "😀".repeat(201) })).status).toBe(400);
  });

  it("rejects a non-string or overlong title", async () => {
    const { alice, teamId } = await world();
    for (const title of [123, null, {}, "x".repeat(201)]) {
      expect((await alice.post(`/api/teams/${teamId}/notes`).send({ title })).status).toBe(400);
    }
  });

  it("every teammate sees the same note", async () => {
    const { alice, bob, teamId } = await world();
    const id = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "Shared" })).body.id;
    expect((await bob.get(`/api/notes/${id}`)).body.title).toBe("Shared");
  });
});

describe("list", () => {
  it("lists a team's notes, most recently updated first, with previews", async () => {
    const { alice, teamId } = await world();
    const a = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "A" })).body.id;
    await tick();
    const b = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "B" })).body.id;
    await tick();
    expect((await alice.get(`/api/teams/${teamId}/notes`)).body.map((n: { id: string }) => n.id)).toEqual([b, a]);

    await alice.patch(`/api/notes/${a}`).send({ title: "A renamed" }); // bumps A to the top
    const list = (await alice.get(`/api/teams/${teamId}/notes`)).body;
    expect(list.map((n: { id: string }) => n.id)).toEqual([a, b]);
    expect(list[0]).toMatchObject({ title: "A renamed", preview: "" });
  });

  it("preview is the first 200 characters of the text", async () => {
    const { alice, teamId } = await world();
    const id = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "Long" })).body.id;
    await ctx.db.query("UPDATE notes SET text = $2 WHERE id = $1", [id, "x".repeat(500)]);
    const [note] = (await alice.get(`/api/teams/${teamId}/notes`)).body;
    expect(note.preview).toBe("x".repeat(200));
    expect(note).not.toHaveProperty("text");
  });

  it("a user on two teams sees each team's notes separately", async () => {
    const { alice, bob, teamId } = await world();
    const betaId = (await bob.post("/api/teams").send({ name: "Beta" })).body.id as number;
    await bob.post(`/api/teams/${betaId}/members`).send({ username: "alice" });
    await alice.post(`/api/teams/${teamId}/notes`).send({ title: "Alpha note" });
    await bob.post(`/api/teams/${betaId}/notes`).send({ title: "Beta note" });

    const titles = async (agent: typeof alice, id: number) =>
      (await agent.get(`/api/teams/${id}/notes`)).body.map((n: { title: string }) => n.title);
    expect(await titles(alice, teamId)).toEqual(["Alpha note"]);
    expect(await titles(alice, betaId)).toEqual(["Beta note"]);
    expect(await titles(bob, betaId)).toEqual(["Beta note"]); // same view from both members
  });
});

describe("rename", () => {
  it("any member can rename; the new title is persisted", async () => {
    const { alice, bob, teamId } = await world();
    const id = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "Old" })).body.id;
    const res = await bob.patch(`/api/notes/${id}`).send({ title: "New" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("New");
    expect((await alice.get(`/api/notes/${id}`)).body.title).toBe("New");
  });

  it("requires a valid title", async () => {
    const { alice, teamId } = await world();
    const id = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "T" })).body.id;
    for (const body of [{}, { title: "" }, { title: "   " }, { title: 5 }, { title: "x".repeat(201) }]) {
      expect((await alice.patch(`/api/notes/${id}`).send(body)).status).toBe(400);
    }
    expect((await alice.get(`/api/notes/${id}`)).body.title).toBe("T");
  });
});

describe("delete", () => {
  it("any member (not just the creator or an admin) can delete; it is gone for everyone", async () => {
    const { alice, bob, teamId } = await world();
    const id = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "Doomed" })).body.id;
    expect((await bob.delete(`/api/notes/${id}`)).status).toBe(204);
    expect((await alice.get(`/api/notes/${id}`)).status).toBe(404);
    expect((await alice.get(`/api/teams/${teamId}/notes`)).body).toEqual([]);
    expect((await bob.delete(`/api/notes/${id}`)).status).toBe(404);
  });

  it("two members deleting at once: one 204, one 404", async () => {
    const { alice, bob, teamId } = await world();
    const id = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "Race" })).body.id;
    const results = await Promise.all([alice.delete(`/api/notes/${id}`), bob.delete(`/api/notes/${id}`)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
  });

  it("deleting a team deletes its notes", async () => {
    const { alice, teamId } = await world();
    await alice.post(`/api/teams/${teamId}/notes`).send({ title: "N" });
    await ctx.db.query("DELETE FROM teams WHERE id = $1", [teamId]);
    expect((await ctx.db.query("SELECT 1 FROM notes")).rows).toHaveLength(0);
  });

  it("deleting the creator's account keeps the note", async () => {
    const { alice, teamId } = await world();
    const bobRow = await ctx.db.query("SELECT id FROM users WHERE username = 'bob'");
    const bob = await ctx.as("bob");
    const id = (await bob.post(`/api/teams/${teamId}/notes`).send({ title: "Kept" })).body.id;
    await ctx.db.query("DELETE FROM users WHERE id = $1", [bobRow.rows[0].id]);
    const got = await alice.get(`/api/notes/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.createdBy).toBeNull();
  });
});

describe("access control", () => {
  it("an outsider gets 404 for everything: list, create, get, rename, delete", async () => {
    const { alice, carol, teamId } = await world();
    const id = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "Secret" })).body.id;

    expect((await carol.get(`/api/teams/${teamId}/notes`)).status).toBe(404);
    expect((await carol.post(`/api/teams/${teamId}/notes`).send({ title: "x" })).status).toBe(404);
    expect((await carol.get(`/api/notes/${id}`)).status).toBe(404);
    expect((await carol.patch(`/api/notes/${id}`).send({ title: "hacked" })).status).toBe(404);
    expect((await carol.delete(`/api/notes/${id}`)).status).toBe(404);
    // ...and nothing changed
    const still = await alice.get(`/api/notes/${id}`);
    expect(still.body.title).toBe("Secret");
  });

  it("a removed member immediately loses access", async () => {
    const { alice, bob, teamId } = await world();
    const id = (await alice.post(`/api/teams/${teamId}/notes`).send({ title: "N" })).body.id;
    expect((await bob.get(`/api/notes/${id}`)).status).toBe(200);
    const bobId = (await alice.get(`/api/teams/${teamId}/members`)).body.find(
      (m: { username: string }) => m.username === "bob",
    ).userId;
    await alice.delete(`/api/teams/${teamId}/members/${bobId}`);
    expect((await bob.get(`/api/notes/${id}`)).status).toBe(404);
    expect((await bob.get(`/api/teams/${teamId}/notes`)).status).toBe(404);
  });

  it("malformed or unknown note ids are 404, never a 500", async () => {
    const { alice } = await world();
    for (const id of ["abc", "123", "1;drop table notes", "00000000-0000-0000-0000-000000000000"]) {
      expect((await alice.get(`/api/notes/${encodeURIComponent(id)}`)).status).toBe(404);
    }
  });
});
