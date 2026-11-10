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

  it("finds users by username and id", async () => {
    const db = freshDb();
    await createSchema(db);
    const repo = createUserRepository(db);
    const created = await repo.create("bob", "hash");
    expect(await repo.findByUsername("bob")).toEqual(created);
    expect(await repo.findById(created.id)).toEqual(created);
    expect(await repo.findByUsername("nobody")).toBeNull();
  });
});
