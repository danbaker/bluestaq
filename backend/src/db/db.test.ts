import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import type { Db } from "./client.js";
import { createSchema } from "./schema.js";
import { seed } from "./seed.js";
import { createUserRepository } from "../repositories/userRepository.js";

const freshDb = () => new (newDb().adapters.createPg().Pool)() as Db;

describe("createSchema", () => {
  it("creates tables", async () => {
    const db = freshDb();
    await createSchema(db);
    await db.query("SELECT * FROM users");
  });
  // Re-running is covered by real Postgres on boot; pg-mem cannot re-run IF NOT EXISTS.
});

describe("seed + user repository", () => {
  it("seeds admin once, hashing the password", async () => {
    const db = freshDb();
    await createSchema(db);
    const opts = { adminUsername: "admin", adminPassword: "pw" };
    await seed(db, opts);
    await seed(db, opts);
    const { rows } = await db.query("SELECT * FROM users");
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toBe("pw");
  });

  it("marks the seeded admin as site admin, even if the user already existed", async () => {
    const db = freshDb();
    await createSchema(db);
    const repo = createUserRepository(db);
    await repo.create("admin", "hash"); // pre-existing, not admin
    expect((await repo.findByUsername("admin"))!.isAdmin).toBe(false);
    await seed(db, { adminUsername: "Admin", adminPassword: "pw" });
    expect((await repo.findByUsername("admin"))!.isAdmin).toBe(true);
    expect((await db.query("SELECT * FROM users")).rows).toHaveLength(1);
  });

  it("finds users by username and id", async () => {
    const db = freshDb();
    await createSchema(db);
    const repo = createUserRepository(db);
    const created = await repo.create("Bob", "hash");
    expect(created.username).toBe("bob");
    expect(await repo.findByUsername("BOB")).toEqual(created);
    expect(await repo.findById(created.id)).toEqual(created);
    expect(await repo.findByUsername("nobody")).toBeNull();
  });
});
