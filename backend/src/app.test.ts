import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { createTestDb, TEST_SECRET, TEST_USER } from "./db/testDb.js";

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  app = createApp({ db: await createTestDb(), jwtSecret: TEST_SECRET });
});

async function login() {
  const res = await request(app).post("/api/auth/login").send(TEST_USER);
  return { res, cookie: res.headers["set-cookie"] as unknown as string[] };
}

describe("public endpoints", () => {
  it("GET /api/health needs no auth", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("login", () => {
  it("sets an httpOnly 24h JWT cookie", async () => {
    const { res, cookie } = await login();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: "admin" });
    expect(cookie[0]).toMatch(/^session=ey/);
    expect(cookie[0]).toContain("HttpOnly");
    expect(cookie[0]).toContain("Max-Age=86400");
  });

  it("rejects bad password and unknown user", async () => {
    for (const body of [
      { username: "admin", password: "wrong" },
      { username: "nobody", password: "x" },
    ]) {
      const res = await request(app).post("/api/auth/login").send(body);
      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("rejects missing fields", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
  });
});

describe("protected endpoints", () => {
  it("GET /api/hello returns 401 without cookie", async () => {
    expect((await request(app).get("/api/hello")).status).toBe(401);
  });

  it("GET /api/hello returns 401 with bad token", async () => {
    const res = await request(app).get("/api/hello").set("Cookie", "session=bad");
    expect(res.status).toBe(401);
  });

  it("GET /api/hello works with session cookie", async () => {
    const { cookie } = await login();
    const res = await request(app).get("/api/hello").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Hello, admin!" });
    const named = await request(app).get("/api/hello?name=Dan").set("Cookie", cookie);
    expect(named.body).toEqual({ message: "Hello, Dan!" });
  });

  it("GET /api/auth/me returns current user", async () => {
    const { cookie } = await login();
    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.body).toEqual({ username: "admin" });
  });
});

describe("logout", () => {
  it("clears the cookie", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(204);
    expect((res.headers["set-cookie"] as unknown as string[])[0]).toMatch(/^session=;/);
  });
});
