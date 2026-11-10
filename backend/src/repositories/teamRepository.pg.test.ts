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
    await db.query("DELETE FROM teams WHERE personal_owner_id IN (SELECT id FROM users WHERE username LIKE $1)", [`race${suffix}%`]);
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

  it("giving a user a private space from many places at once creates exactly one (x25)", async () => {
    for (let i = 200; i < 225; i++) {
      const user = await users.create(`race${suffix}p${i}`, "x");
      const ids = await Promise.all([1, 2, 3, 4].map(() => teams.ensurePersonalTeam(user.id)));
      expect(new Set(ids).size).toBe(1);
      const { rows } = await db.query("SELECT count(*)::int AS n FROM teams WHERE personal_owner_id = $1", [user.id]);
      expect(rows[0].n).toBe(1);
      expect(await teams.getRole(ids[0], user.id)).toBe("admin");
    }
  });

  it("the repository itself refuses to add a second member to a private space", async () => {
    const owner = await users.create(`race${suffix}own`, "x");
    const other = await users.create(`race${suffix}oth`, "x");
    const spaceId = await teams.ensurePersonalTeam(owner.id);
    await expect(teams.addMember(spaceId, other.id, "member")).rejects.toThrow(/private space/);
    expect(await teams.getRole(spaceId, other.id)).toBeNull();
  });

  it("a private space whose membership row is missing is repaired", async () => {
    const user = await users.create(`race${suffix}repair`, "x");
    const id = await teams.ensurePersonalTeam(user.id);
    await db.query("DELETE FROM team_members WHERE team_id = $1", [id]);
    expect(await teams.ensurePersonalTeam(user.id)).toBe(id);
    expect(await teams.getRole(id, user.id)).toBe("admin");
  });

  it("create is atomic: a failing membership insert leaves no orphan team", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM teams")).rows[0].n;
    await expect(teams.create(`race-${suffix}-orphan`, 2_000_000_000)).rejects.toThrow(); // no such user -> FK error
    const after = (await db.query("SELECT count(*)::int AS n FROM teams")).rows[0].n;
    expect(after).toBe(before);
  });
});
