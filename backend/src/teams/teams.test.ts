import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app.js";
import { createTestDb, TEST_SECRET, TEST_USER } from "../db/testDb.js";
import { createUserRepository } from "../repositories/userRepository.js";

const PASSWORD = "password123";

async function setup() {
  const db = await createTestDb();
  const users = createUserRepository(db);
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const name of ["alice", "bob", "carol"]) await users.create(name, hash);
  const app = createApp({ db, jwtSecret: TEST_SECRET });

  const as = async (username: string, password = PASSWORD) => {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/login").send({ username, password });
    expect(res.status).toBe(200);
    return agent;
  };
  return { app, as };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

describe("auth required", () => {
  it.each([
    ["get", "/api/teams"],
    ["post", "/api/teams"],
    ["get", "/api/teams/1/members"],
    ["post", "/api/users"],
  ] as const)("%s %s returns 401 when logged out", async (method, path) => {
    expect((await request(ctx.app)[method](path)).status).toBe(401);
  });
});

describe("POST /api/users", () => {
  it("lets the site admin create a user who can then log in", async () => {
    const admin = await ctx.as(TEST_USER.username, TEST_USER.password);
    const res = await admin.post("/api/users").send({ username: "dave", password: "longenough" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(Number), username: "dave" });
    expect(res.body.passwordHash).toBeUndefined();
    await ctx.as("dave", "longenough");
  });

  it("forbids everyone else", async () => {
    const alice = await ctx.as("alice");
    const res = await alice.post("/api/users").send({ username: "dave", password: "longenough" });
    expect(res.status).toBe(403);
  });

  it("usernames are case-insensitive: stored lowercase, duplicates by case rejected, login ignores case", async () => {
    const admin = await ctx.as(TEST_USER.username, TEST_USER.password);
    const res = await admin.post("/api/users").send({ username: "Dave", password: "longenough" });
    expect(res.body.username).toBe("dave");
    expect((await admin.post("/api/users").send({ username: "DAVE", password: "longenough" })).status).toBe(409);
    expect((await admin.post("/api/users").send({ username: "Alice", password: "longenough" })).status).toBe(409);
    await ctx.as("DaVe", "longenough");
  });

  it("two simultaneous creates of one username: one 201, one 409, never a 500", async () => {
    const admin = await ctx.as(TEST_USER.username, TEST_USER.password);
    const body = { username: "erin", password: "longenough" };
    const statuses = (await Promise.all([admin.post("/api/users").send(body), admin.post("/api/users").send(body)]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("validates input and rejects duplicates", async () => {
    const admin = await ctx.as(TEST_USER.username, TEST_USER.password);
    expect((await admin.post("/api/users").send({ username: "x y", password: "longenough" })).status).toBe(400);
    expect((await admin.post("/api/users").send({ username: "dave", password: "short" })).status).toBe(400);
    expect((await admin.post("/api/users").send({ username: "alice", password: "longenough" })).status).toBe(409);
  });
});

describe("teams", () => {
  it("creator becomes admin; team shows in their list", async () => {
    const alice = await ctx.as("alice");
    const res = await alice.post("/api/teams").send({ name: "  Eng  " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(Number), name: "Eng", role: "admin" });
    expect((await alice.get("/api/teams")).body).toEqual([res.body]);
  });

  it("rejects missing or overlong names", async () => {
    const alice = await ctx.as("alice");
    expect((await alice.post("/api/teams").send({})).status).toBe(400);
    expect((await alice.post("/api/teams").send({ name: "   " })).status).toBe(400);
    expect((await alice.post("/api/teams").send({ name: "x".repeat(101) })).status).toBe(400);
  });

  it("a user on two teams sees both, with the right role in each", async () => {
    const alice = await ctx.as("alice");
    const bob = await ctx.as("bob");
    const a = (await alice.post("/api/teams").send({ name: "Alpha" })).body;
    const b = (await bob.post("/api/teams").send({ name: "Beta" })).body;
    await bob.post(`/api/teams/${b.id}/members`).send({ username: "alice" });

    const list = (await alice.get("/api/teams")).body;
    expect(list).toEqual([
      { id: a.id, name: "Alpha", role: "admin" },
      { id: b.id, name: "Beta", role: "member" },
    ]);
    // Bob only sees his own team.
    expect((await bob.get("/api/teams")).body).toEqual([{ id: b.id, name: "Beta", role: "admin" }]);
  });
});

describe("members", () => {
  async function aliceTeam() {
    const alice = await ctx.as("alice");
    const team = (await alice.post("/api/teams").send({ name: "Alpha" })).body;
    return { alice, id: team.id as number };
  }

  it("admin adds a member; members can list members", async () => {
    const { alice, id } = await aliceTeam();
    const res = await alice.post(`/api/teams/${id}/members`).send({ username: "bob" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: "bob", role: "member" });

    const bob = await ctx.as("bob");
    const members = (await bob.get(`/api/teams/${id}/members`)).body;
    expect(members.map((m: { username: string; role: string }) => [m.username, m.role])).toEqual([
      ["alice", "admin"],
      ["bob", "member"],
    ]);
  });

  it("non-members get 404 (no id leak), including for malformed and unknown ids", async () => {
    const { id } = await aliceTeam();
    const carol = await ctx.as("carol");
    expect((await carol.get(`/api/teams/${id}/members`)).status).toBe(404);
    expect((await carol.post(`/api/teams/${id}/members`).send({ username: "carol" })).status).toBe(404);
    expect((await carol.get("/api/teams/99999/members")).status).toBe(404);
    expect((await carol.get("/api/teams/abc/members")).status).toBe(404);
    expect((await carol.get("/api/teams/1;drop/members")).status).toBe(404);
  });

  it("plain members cannot add or remove others", async () => {
    const { alice, id } = await aliceTeam();
    await alice.post(`/api/teams/${id}/members`).send({ username: "bob" });
    await alice.post(`/api/teams/${id}/members`).send({ username: "carol" });
    const bob = await ctx.as("bob");
    expect((await bob.post(`/api/teams/${id}/members`).send({ username: "carol" })).status).toBe(403);
    const carolId = (await alice.get(`/api/teams/${id}/members`)).body.find(
      (m: { username: string }) => m.username === "carol",
    ).userId;
    expect((await bob.delete(`/api/teams/${id}/members/${carolId}`)).status).toBe(403);
  });

  it("validates add-member input; 404 for unknown user; 409 for duplicate", async () => {
    const { alice, id } = await aliceTeam();
    expect((await alice.post(`/api/teams/${id}/members`).send({})).status).toBe(400);
    expect((await alice.post(`/api/teams/${id}/members`).send({ username: "bob", role: "owner" })).status).toBe(400);
    expect((await alice.post(`/api/teams/${id}/members`).send({ username: "nobody" })).status).toBe(404);
    await alice.post(`/api/teams/${id}/members`).send({ username: "bob" });
    expect((await alice.post(`/api/teams/${id}/members`).send({ username: "bob" })).status).toBe(409);
    expect((await alice.post(`/api/teams/${id}/members`).send({ username: "alice" })).status).toBe(409);
  });

  it("admin can remove a member, who then loses access", async () => {
    const { alice, id } = await aliceTeam();
    const bobId = (await alice.post(`/api/teams/${id}/members`).send({ username: "bob" })).body.userId;
    const bob = await ctx.as("bob");
    expect((await bob.get(`/api/teams/${id}/members`)).status).toBe(200);

    expect((await alice.delete(`/api/teams/${id}/members/${bobId}`)).status).toBe(204);
    expect((await bob.get(`/api/teams/${id}/members`)).status).toBe(404);
    expect((await alice.delete(`/api/teams/${id}/members/${bobId}`)).status).toBe(404);
  });

  it("a member can leave", async () => {
    const { alice, id } = await aliceTeam();
    const bobId = (await alice.post(`/api/teams/${id}/members`).send({ username: "bob" })).body.userId;
    const bob = await ctx.as("bob");
    expect((await bob.delete(`/api/teams/${id}/members/${bobId}`)).status).toBe(204);
    expect((await bob.get("/api/teams")).body).toEqual([]);
  });

  it("the last admin cannot be removed or leave; a second admin can", async () => {
    const { alice, id } = await aliceTeam();
    const aliceId = (await alice.get(`/api/teams/${id}/members`)).body[0].userId;
    expect((await alice.delete(`/api/teams/${id}/members/${aliceId}`)).status).toBe(409);

    await alice.post(`/api/teams/${id}/members`).send({ username: "bob", role: "admin" });
    expect((await alice.delete(`/api/teams/${id}/members/${aliceId}`)).status).toBe(204);
    const bob = await ctx.as("bob");
    const bobId = (await bob.get(`/api/teams/${id}/members`)).body[0].userId;
    expect((await bob.delete(`/api/teams/${id}/members/${bobId}`)).status).toBe(409);
  });

  it("rejects a malformed member id", async () => {
    const { alice, id } = await aliceTeam();
    expect((await alice.delete(`/api/teams/${id}/members/abc`)).status).toBe(404);
  });
});

describe("member roles", () => {
  async function team() {
    const alice = await ctx.as("alice");
    const id = (await alice.post("/api/teams").send({ name: "Alpha" })).body.id as number;
    const bobId = (await alice.post(`/api/teams/${id}/members`).send({ username: "bob" })).body.userId as number;
    return { alice, id, bobId };
  }

  it("admin promotes and demotes a member", async () => {
    const { alice, id, bobId } = await team();
    const up = await alice.patch(`/api/teams/${id}/members/${bobId}`).send({ role: "admin" });
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ userId: bobId, role: "admin" });
    // bob can now add members
    const bob = await ctx.as("bob");
    expect((await bob.post(`/api/teams/${id}/members`).send({ username: "carol" })).status).toBe(201);
    expect((await alice.patch(`/api/teams/${id}/members/${bobId}`).send({ role: "member" })).status).toBe(200);
  });

  it("only admins can change roles; non-members get 404", async () => {
    const { alice, id, bobId } = await team();
    const bob = await ctx.as("bob");
    expect((await bob.patch(`/api/teams/${id}/members/${bobId}`).send({ role: "admin" })).status).toBe(403);
    const carol = await ctx.as("carol");
    expect((await carol.patch(`/api/teams/${id}/members/${bobId}`).send({ role: "admin" })).status).toBe(404);
    expect((await alice.get(`/api/teams/${id}/members`)).body.find((m: { userId: number }) => m.userId === bobId).role).toBe(
      "member",
    );
  });

  it("validates role and target; refuses to demote the last admin", async () => {
    const { alice, id, bobId } = await team();
    const aliceId = (await alice.get(`/api/teams/${id}/members`)).body[0].userId;
    expect((await alice.patch(`/api/teams/${id}/members/${bobId}`).send({ role: "owner" })).status).toBe(400);
    expect((await alice.patch(`/api/teams/${id}/members/999`).send({ role: "admin" })).status).toBe(404);
    expect((await alice.patch(`/api/teams/${id}/members/abc`).send({ role: "admin" })).status).toBe(404);
    expect((await alice.patch(`/api/teams/${id}/members/${aliceId}`).send({ role: "member" })).status).toBe(409);
  });
});

describe("error handling", () => {
  it("malformed JSON returns 400 JSON, not an HTML stack trace", async () => {
    const alice = await ctx.as("alice");
    const res = await alice.post("/api/teams").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON" });
  });
});
