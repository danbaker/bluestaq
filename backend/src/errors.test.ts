import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { setupTestApp } from "./testApp.js";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeEach(async () => {
  ctx = await setupTestApp();
});
afterEach(() => vi.restoreAllMocks());

describe("errors are always JSON", () => {
  it("malformed JSON is a 400", async () => {
    const alice = await ctx.as("alice");
    const res = await alice.post("/api/teams").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON" });
  });

  it("an oversized body is a 413, not a 500", async () => {
    const alice = await ctx.as("alice");
    const res = await alice.post("/api/teams").send({ name: "x".repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Request body too large" });
  });

  it("an unknown API route is a JSON 404 for every method, logged in or not", async () => {
    const alice = await ctx.as("alice");
    for (const agent of [alice, request(ctx.app)]) {
      for (const method of ["get", "post", "patch", "delete"] as const) {
        const res = await agent[method]("/api/does-not-exist");
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Not found" });
      }
    }
  });

  it("an unexpected failure is a generic 500 that leaks no details or stack", async () => {
    const alice = await ctx.as("alice");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ctx.db, "query").mockRejectedValue(new Error("connect ECONNREFUSED postgres://userx:pw@db.internal"));
    const res = await alice.get("/api/teams");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(res.text).not.toMatch(/ECONNREFUSED|postgres:|userx|\sat\s/);
  });

  it("odd request bodies never cause a 500, on any endpoint that takes one", async () => {
    // The site admin, who is also admin of a real team with a real note, so every handler is reachable.
    const admin = await ctx.as("admin", "admin123");
    const teamId = (await admin.post("/api/teams").send({ name: "T" })).body.id as number;
    const noteId = (await admin.post(`/api/teams/${teamId}/notes`).send({ title: "N" })).body.id as string;
    const adminId = (await admin.get(`/api/teams/${teamId}/members`)).body[0].userId as number;

    const endpoints: [method: "post" | "patch", path: string][] = [
      ["post", "/api/auth/login"],
      ["post", "/api/users"],
      ["post", "/api/teams"],
      ["post", `/api/teams/${teamId}/members`],
      ["patch", `/api/teams/${teamId}/members/${adminId}`],
      ["post", `/api/teams/${teamId}/notes`],
      ["patch", `/api/notes/${noteId}`],
    ];

    // Control: with an empty object each handler is reached and answers 400 (or accepts it), never 403/404.
    for (const [method, path] of endpoints) {
      const res = await admin[method](path).send({});
      expect([200, 201, 400], `control ${method} ${path}`).toContain(res.status);
    }

    const bodies: [string, string][] = [
      ["application/json", "[]"],
      ["application/json", "null"],
      ["application/json", '"text"'],
      ["application/json", "123"],
      ["application/json", '{"username":{"$ne":1},"password":[1],"name":{},"title":[],"role":{}}'],
      ["text/plain", "just text"],
      ["application/x-www-form-urlencoded", "name=x&title=y"],
    ];
    for (const [method, path] of endpoints) {
      for (const [type, body] of bodies) {
        const res = await admin[method](path).set("Content-Type", type).send(body);
        expect(res.status, `${method} ${path} with ${type} ${body}`).toBeLessThan(500);
        expect(res.headers["content-type"]).toMatch(/json/);
      }
    }
  });
});
