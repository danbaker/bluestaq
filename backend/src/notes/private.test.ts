import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { seed } from "../db/seed.js";
import { TEST_USER } from "../db/testDb.js";
import { createUserRepository } from "../repositories/userRepository.js";
import { setupTestApp, PASSWORD } from "../testApp.js";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeEach(async () => {
  ctx = await setupTestApp();
});

type Team = { id: number; name: string; role: string; personal: boolean };
const privateSpace = async (agent: { get: (p: string) => Promise<{ body: unknown }> }) =>
  ((await agent.get("/api/teams")).body as Team[]).find((t) => t.personal)!;

describe("every user has a private space", () => {
  it("each user has exactly one, named Private, where they are the admin; nobody else sees it", async () => {
    const [alice, bob] = [await ctx.as("alice"), await ctx.as("bob")];
    const a = await privateSpace(alice);
    const b = await privateSpace(bob);
    expect(a).toEqual({ id: expect.any(Number), name: "Private", role: "admin", personal: true });
    expect(a.id).not.toBe(b.id);
    for (const agent of [alice, bob]) {
      expect(((await agent.get("/api/teams")).body as Team[]).filter((t) => t.personal)).toHaveLength(1);
    }
    expect(((await bob.get("/api/teams")).body as Team[]).map((t) => t.id)).not.toContain(a.id);
  });

  it("a user created by the site admin gets one straight away", async () => {
    const admin = await ctx.as(TEST_USER.username, TEST_USER.password);
    await admin.post("/api/users").send({ username: "dave", password: "longenough" });
    const dave = await ctx.as("dave", "longenough");
    expect(await privateSpace(dave)).toMatchObject({ name: "Private", role: "admin", personal: true });
  });

  it("users who existed before private notes are given one at startup, and booting again changes nothing", async () => {
    const users = createUserRepository(ctx.db);
    await users.create("legacy", await bcrypt.hash(PASSWORD, 4)); // created the old way: no private space
    const count = async () => (await ctx.db.query("SELECT count(*)::int AS n FROM teams WHERE personal_owner_id IS NOT NULL")).rows[0].n as number;
    const before = await count();
    const boot = () => seed(ctx.db, { adminUsername: TEST_USER.username, adminPassword: TEST_USER.password }); // what startup runs
    await boot();
    await boot();
    expect(await count()).toBe(before + 1);
    expect(await privateSpace(await ctx.as("legacy"))).toMatchObject({ personal: true });
  });

  it("the name Private is reserved, so a shared team can never pass for the private space", async () => {
    const alice = await ctx.as("alice");
    for (const name of ["Private", "private", "  PRIVATE "]) {
      const res = await alice.post("/api/teams").send({ name });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reserved/);
    }
    expect((await alice.post("/api/teams").send({ name: "Private notes club" })).status).toBe(201); // only the exact name
    expect(((await alice.get("/api/teams")).body as Team[]).filter((t) => t.name === "Private")).toHaveLength(1);
  });

  it("the private space is always listed first", async () => {
    const alice = await ctx.as("alice");
    await alice.post("/api/teams").send({ name: "Aardvarks" });
    await alice.post("/api/teams").send({ name: "Zebras" });
    expect(((await alice.get("/api/teams")).body as Team[]).map((t) => t.name)).toEqual(["Private", "Aardvarks", "Zebras"]);
  });

  it("logging in gives anyone who somehow lacks one a private space", async () => {
    const users = createUserRepository(ctx.db);
    await users.create("latecomer", await bcrypt.hash(PASSWORD, 4)); // no private space yet
    const latecomer = await ctx.as("latecomer"); // logging in creates it
    expect(await privateSpace(latecomer)).toMatchObject({ name: "Private", personal: true });
  });

  it("a user whose private space fails to be created is still created, and gets it at first login", async () => {
    const admin = await ctx.as(TEST_USER.username, TEST_USER.password);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const realQuery = ctx.db.query.bind(ctx.db) as (sql: string, params?: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(ctx.db, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO teams \(name, personal_owner_id\)/.test(sql)) throw new Error("database hiccup");
      return realQuery(sql, params);
    }) as never);
    const res = await admin.post("/api/users").send({ username: "unlucky", password: "longenough" });
    spy.mockRestore();
    errorLog.mockRestore();
    expect(res.status).toBe(201); // not a 500, and not a misleading "username taken"
    expect((await admin.post("/api/users").send({ username: "unlucky", password: "longenough" })).status).toBe(409);
    expect(await privateSpace(await ctx.as("unlucky", "longenough"))).toMatchObject({ personal: true });
  });
});

describe("working with private notes", () => {
  it("the owner can create, read, rename and delete them", async () => {
    const alice = await ctx.as("alice");
    const space = await privateSpace(alice);
    const note = (await alice.post(`/api/teams/${space.id}/notes`).send({ title: "Diary" })).body;
    expect(note).toMatchObject({ title: "Diary", teamId: space.id });
    expect((await alice.get(`/api/notes/${note.id}`)).body.title).toBe("Diary");
    expect((await alice.patch(`/api/notes/${note.id}`).send({ title: "Journal" })).body.title).toBe("Journal");
    expect((await alice.get(`/api/teams/${space.id}/notes`)).body.map((n: { title: string }) => n.title)).toEqual(["Journal"]);
    expect((await alice.delete(`/api/notes/${note.id}`)).status).toBe(204);
    expect((await alice.get(`/api/notes/${note.id}`)).status).toBe(404);
  });

  it("they appear in the all-notes list next to team notes, marked as private", async () => {
    const alice = await ctx.as("alice");
    const space = await privateSpace(alice);
    const teamId = (await alice.post("/api/teams").send({ name: "Alpha" })).body.id as number;
    await alice.post(`/api/teams/${space.id}/notes`).send({ title: "Mine only" });
    await alice.post(`/api/teams/${teamId}/notes`).send({ title: "For the team" });

    const list = (await alice.get("/api/notes")).body as { title: string; teamName: string; personal: boolean }[];
    expect(list.map((n) => [n.teamName, n.title, n.personal]).sort()).toEqual([
      ["Alpha", "For the team", false],
      ["Private", "Mine only", true],
    ]);
  });
});

describe("nobody else can reach a private note", () => {
  async function aliceWithSecret() {
    const alice = await ctx.as("alice");
    const space = await privateSpace(alice);
    const noteId = (await alice.post(`/api/teams/${space.id}/notes`).send({ title: "Secret plans" })).body.id as string;
    return { alice, space, noteId };
  }

  it("teammates, strangers and even the site admin get 404 for every route", async () => {
    const { alice, space, noteId } = await aliceWithSecret();
    // bob is alice's teammate on a shared team; the admin is the site admin
    const bob = await ctx.as("bob");
    const teamId = (await alice.post("/api/teams").send({ name: "Shared" })).body.id as number;
    await alice.post(`/api/teams/${teamId}/members`).send({ username: "bob" });
    const others = [bob, await ctx.as("carol"), await ctx.as(TEST_USER.username, TEST_USER.password)];

    for (const other of others) {
      expect((await other.get(`/api/teams/${space.id}/notes`)).status).toBe(404);
      expect((await other.post(`/api/teams/${space.id}/notes`).send({ title: "intruder" })).status).toBe(404);
      expect((await other.get(`/api/teams/${space.id}/members`)).status).toBe(404);
      expect((await other.get(`/api/notes/${noteId}`)).status).toBe(404);
      expect((await other.patch(`/api/notes/${noteId}`).send({ title: "hacked" })).status).toBe(404);
      expect((await other.delete(`/api/notes/${noteId}`)).status).toBe(404);
      expect((await other.get(`/api/notes/${noteId}/presence`)).status).toBe(404);
      expect((await other.post(`/api/teams/${space.id}/members`).send({ username: "carol" })).status).toBe(404);
      expect(((await other.get("/api/notes")).body as { title: string }[]).map((n) => n.title)).not.toContain("Secret plans");
      expect(((await other.get("/api/teams")).body as Team[]).map((t) => t.id)).not.toContain(space.id);
    }
    // untouched
    const still = await alice.get(`/api/notes/${noteId}`);
    expect(still.body.title).toBe("Secret plans");
    expect((await alice.get(`/api/teams/${space.id}/members`)).body).toHaveLength(1);
  });

  it("logged-out visitors are refused", async () => {
    const { noteId, space } = await aliceWithSecret();
    expect((await request(ctx.app).get(`/api/notes/${noteId}`)).status).toBe(401);
    expect((await request(ctx.app).get(`/api/teams/${space.id}/notes`)).status).toBe(401);
  });
});

describe("the private space cannot be shared or changed", () => {
  it("not even the owner can add members, promote, remove, or leave", async () => {
    const alice = await ctx.as("alice");
    const space = await privateSpace(alice);
    const members = async () => (await alice.get(`/api/teams/${space.id}/members`)).body as { userId: number; username: string; role: string }[];
    const aliceId = (await members())[0].userId;

    expect((await alice.post(`/api/teams/${space.id}/members`).send({ username: "bob" })).status).toBe(403);
    expect((await alice.post(`/api/teams/${space.id}/members`).send({ username: "bob", role: "admin" })).status).toBe(403);
    expect((await alice.patch(`/api/teams/${space.id}/members/${aliceId}`).send({ role: "member" })).status).toBe(403);
    expect((await alice.delete(`/api/teams/${space.id}/members/${aliceId}`)).status).toBe(403); // "leave"
    expect(await members()).toEqual([{ userId: aliceId, username: "alice", role: "admin" }]);
    // and bob really was not added
    expect(((await (await ctx.as("bob")).get("/api/teams")).body as Team[]).map((t) => t.id)).not.toContain(space.id);
  });
});

describe("when a user is removed from the system", () => {
  it("their private space and its notes go with them, and shared teams keep working", async () => {
    const [alice, bob] = [await ctx.as("alice"), await ctx.as("bob")];
    const space = await privateSpace(alice);
    await alice.post(`/api/teams/${space.id}/notes`).send({ title: "Private one" });
    const shared = (await alice.post("/api/teams").send({ name: "Shared" })).body.id as number;
    await alice.post(`/api/teams/${shared}/members`).send({ username: "bob" });
    await bob.post(`/api/teams/${shared}/notes`).send({ title: "Team note" });

    await ctx.db.query("DELETE FROM users WHERE username = 'alice'");
    expect((await ctx.db.query("SELECT 1 FROM teams WHERE id = $1", [space.id])).rows).toHaveLength(0);
    expect((await ctx.db.query("SELECT 1 FROM notes WHERE title = 'Private one'")).rows).toHaveLength(0);
    expect(((await bob.get("/api/notes")).body as { title: string }[]).map((n) => n.title)).toEqual(["Team note"]);
  });
});
