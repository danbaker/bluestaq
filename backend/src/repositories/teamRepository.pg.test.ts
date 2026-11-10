// Runs against REAL Postgres (database "bluestaq_test", created on demand). pg-mem can't test
// row locking, so races live here. The suite skips itself if Postgres isn't reachable.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectRealTestDb } from "../db/testDb.js";
import { createTeamRepository } from "./teamRepository.js";
import { createUserRepository } from "./userRepository.js";

const pool = await connectRealTestDb("bluestaq_test");

describe.skipIf(!pool)("teamRepository on real Postgres", () => {
  const db = pool!;
  const users = createUserRepository(db);
  const teams = createTeamRepository(db);
  const suffix = Date.now().toString(36);

  afterAll(async () => {
    await db.query("DELETE FROM teams WHERE name LIKE $1", [`race-${suffix}%`]);
    await db.query("DELETE FROM users WHERE username LIKE $1", [`race${suffix}%`]);
    await db.end();
  });

  async function twoAdmins(n: number) {
    const a = await users.create(`race${suffix}a${n}`, "x");
    const b = await users.create(`race${suffix}b${n}`, "x");
    const team = await teams.create(`race-${suffix}-${n}`, a.id);
    await teams.addMember(team.id, b.id, "admin");
    return { team, a, b };
  }

  it("two admins removed at the same time: exactly one succeeds, one admin remains (x25)", async () => {
    for (let i = 0; i < 25; i++) {
      const { team, a, b } = await twoAdmins(i);
      const results = await Promise.all([teams.removeMember(team.id, a.id), teams.removeMember(team.id, b.id)]);
      expect([...results].sort()).toEqual(["last_admin", "removed"]);
      expect(await teams.countAdmins(team.id)).toBe(1);
    }
  });

  it("two admins demoted at the same time: exactly one succeeds (x25)", async () => {
    for (let i = 100; i < 125; i++) {
      const { team, a, b } = await twoAdmins(i);
      const results = await Promise.all([teams.setRole(team.id, a.id, "member"), teams.setRole(team.id, b.id, "member")]);
      expect([...results].sort()).toEqual(["last_admin", "updated"]);
      expect(await teams.countAdmins(team.id)).toBe(1);
    }
  });

  it("create is atomic: a failing membership insert leaves no orphan team", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM teams")).rows[0].n;
    await expect(teams.create(`race-${suffix}-orphan`, 2_000_000_000)).rejects.toThrow(); // no such user -> FK error
    const after = (await db.query("SELECT count(*)::int AS n FROM teams")).rows[0].n;
    expect(after).toBe(before);
  });
});
